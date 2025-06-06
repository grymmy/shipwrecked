import { prisma } from "@/lib/prisma";
import { fetchHackatimeProjects } from "@/lib/hackatime";
import { addHackatimeProjectLink } from "@/lib/hackatime-links";

export type Project = {
    projectID: string
    name: string
    description: string
    codeUrl: string
    playableUrl: string
    screenshot: string
    submitted: boolean
    userId: string
    shipped: boolean
    viral: boolean
    in_review: boolean
}

export type ProjectInput = Omit<Project, 'projectID' | 'submitted'> & {
    hackatimeName?: string; // Keep this in the input for backward compatibility
    hackatimeProjects?: string[]; // For multiple hackatime projects
};
export type ProjectUpdateInput = Partial<Omit<Project, 'projectID' | 'userId' | 'submitted'>>;

export async function createProject(data: ProjectInput) {
    console.log('[createProject-TRACE] 1. Starting project creation with data:', {
        name: data.name,
        description: data.description?.substring(0, 20) + '...',
        hackatimeName: data.hackatimeName || 'N/A',
        hackatimeProjects: data.hackatimeProjects || [],
        userId: data.userId,
        hasCodeUrl: !!data.codeUrl,
        hasPlayableUrl: !!data.playableUrl,
        hasScreenshot: !!data.screenshot
    });
    
    // Ensure hackatime is defined
    const hackatimeName = data.hackatimeName || "";
    const hackatimeProjects = data.hackatimeProjects || [];
    
    // Merge hackatimeName into hackatimeProjects if not already there
    if (hackatimeName && !hackatimeProjects.includes(hackatimeName)) {
        hackatimeProjects.push(hackatimeName);
    }
    
    console.log('[createProject-TRACE] 3. Hackatime projects:', hackatimeProjects);
    
    try {
        console.log('[createProject-TRACE] 5. Preparing project payload');
        // Create a complete payload to log and use for Prisma
        const projectPayload = {
            projectID: crypto.randomUUID(),
            name: data.name || 'Unnamed Project',
            description: data.description || '',
            codeUrl: data.codeUrl || '',
            playableUrl: data.playableUrl || '',
            screenshot: data.screenshot || "",
            userId: data.userId,
            submitted: false,
            shipped: !!data.shipped,
            viral: !!data.viral,
            in_review: !!data.in_review,
        };
        
        console.log('[createProject-TRACE] 6. Project payload created:', {
            ...projectPayload,
            screenshot: projectPayload.screenshot ? `(screenshot data, length: ${projectPayload.screenshot.length})` : '(none)'
        });
        
        // Verify database connection by doing a simple query
        console.log('[createProject-TRACE] 7. Verifying database connection...');
        try {
            const result = await prisma.$queryRaw`SELECT 1 as connection_test`;
            console.log('[createProject-TRACE] 7.1 Database connection verified:', result);
        } catch (connectionError) {
            console.error('[createProject-TRACE] 7.2 Database connection test failed:', connectionError);
            throw new Error('Database connection failed: ' + 
                (connectionError instanceof Error ? connectionError.message : 'Unknown error'));
        }
        
        // Check if userId exists in the database
        console.log(`[createProject-TRACE] 8. Checking if user ${data.userId} exists`);
        let userExists;
        try {
            userExists = await prisma.user.findUnique({
                where: { id: data.userId }
            });
            console.log(`[createProject-TRACE] 8.1 User query result:`, userExists ? 'User found' : 'User NOT found');
        } catch (userLookupError) {
            console.error(`[createProject-TRACE] 8.2 Error looking up user:`, userLookupError);
            throw new Error('Failed to verify user: ' + 
                (userLookupError instanceof Error ? userLookupError.message : 'Unknown error'));
        }
        
        if (!userExists) {
            console.error(`[createProject-TRACE] 8.3 User with ID ${data.userId} not found in database`);
            throw new Error(`User with ID ${data.userId} not found`);
        }
        
        try {
            console.log('[createProject-TRACE] 9. Now creating project in database');
            console.time('[createProject-TRACE] Prisma.project.create execution time');
            
            let creationResult;
            try {
                console.log('[createProject-TRACE] 9.1 Calling prisma.project.create');
                creationResult = await prisma.project.create({
                    data: projectPayload
                });
                console.log('[createProject-TRACE] 9.2 prisma.project.create call completed successfully');
            } catch (innerError: any) {
                console.timeEnd('[createProject-TRACE] Prisma.project.create execution time');
                console.error('[createProject-TRACE] 9.3 Inner execution error during project creation:', innerError);
                if (innerError.code) {
                    console.error('[createProject-TRACE] 9.3.1 Prisma error code:', innerError.code);
                }
                if (innerError.clientVersion) {
                    console.error('[createProject-TRACE] 9.3.2 Prisma client version:', innerError.clientVersion);
                }
                throw innerError;
            }
            
            console.timeEnd('[createProject-TRACE] Prisma.project.create execution time');
            
            if (!creationResult) {
                console.error('[createProject-TRACE] 9.4 Prisma returned null/undefined result without throwing an error');
                throw new Error('Project creation failed - database returned null result');
            }
            
            console.log('[createProject-TRACE] 10. Project created successfully with ID:', creationResult.projectID);
            
            // If hackatime projects are provided, create links to them
            if (hackatimeProjects.length > 0) {
                console.log('[createProject-TRACE] 11. Creating Hackatime project links for:', hackatimeProjects);
                const linkPromises = [];
                
                for (const projectName of hackatimeProjects) {
                    try {
                        linkPromises.push(addHackatimeProjectLink(creationResult.projectID, projectName));
                    } catch (linkError) {
                        console.error(`[createProject-TRACE] 11.2 Error creating Hackatime project link for ${projectName}:`, linkError);
                        // Continue even if one link creation fails
                    }
                }
                
                try {
                    await Promise.allSettled(linkPromises);
                    console.log(`[createProject-TRACE] 11.1 Successfully created ${linkPromises.length} Hackatime project links`);
                } catch (error) {
                    console.error('[createProject-TRACE] 11.3 Error waiting for link creations:', error);
                    // Continue even if link creation fails
                }
            }
            
            return creationResult;
        } catch (prismaError: any) {
            console.error('[createProject-TRACE] 12. Prisma error details:', prismaError);
            
            // Check for known error types
            const errorMessage = prismaError.message || '';
            console.error('[createProject-TRACE] 12.1 Error message:', errorMessage);
            
            if (errorMessage.includes('Unique constraint')) {
                if (errorMessage.includes('projectID')) {
                    // Project ID collision - very unlikely but possible
                    console.error('[createProject-TRACE] 12.2 Project ID collision, retrying with a new ID');
                    
                    // Try once more with a new projectID
                    projectPayload.projectID = crypto.randomUUID();
                    console.log('[createProject-TRACE] 12.3 Retrying with new projectID:', projectPayload.projectID);
                    
                    try {
                        const project = await prisma.project.create({
                            data: projectPayload
                        });
                        console.log('[createProject-TRACE] 12.4 Project created successfully on second attempt:', project.projectID);
                        
                        // If hackatime projects are provided, create links to them
                        if (hackatimeProjects.length > 0) {
                            console.log('[createProject-TRACE] 12.5 Creating Hackatime project links for:', hackatimeProjects);
                            const linkPromises = [];
                            
                            for (const projectName of hackatimeProjects) {
                                try {
                                    linkPromises.push(addHackatimeProjectLink(project.projectID, projectName));
                                } catch (linkError) {
                                    console.error(`[createProject-TRACE] 12.6 Error creating Hackatime project link for ${projectName}:`, linkError);
                                    // Continue even if one link creation fails
                                }
                            }
                            
                            try {
                                await Promise.allSettled(linkPromises);
                                console.log(`[createProject-TRACE] 12.1 Successfully created ${linkPromises.length} Hackatime project links`);
                            } catch (error) {
                                console.error('[createProject-TRACE] 12.3 Error waiting for link creations:', error);
                                // Continue even if link creation fails
                            }
                        }
                        
                        return project;
                    } catch (retryError: any) {
                        console.error('[createProject-TRACE] 12.8 Retry also failed:', retryError);
                        throw new Error('Project creation failed on retry: ' + 
                            (retryError.message || 'Unknown error'));
                    }
                }
            }
            
            // If we got here, it's an error we don't know how to handle
            throw new Error('Project creation failed: ' + 
                (prismaError.message || 'Unknown database error'));
        }
    } catch (error) {
        console.error('[createProject-TRACE] 13. Failed to create project in database:', error);
        if (error instanceof Error) {
            console.error('[createProject-TRACE] 13.1 Error name:', error.name);
            console.error('[createProject-TRACE] 13.2 Error message:', error.message);
            console.error('[createProject-TRACE] 13.3 Error stack:', error.stack);
        }
        throw error; // Re-throw to be handled by the caller
    }
}

export async function deleteProject(projectID: string, userId: string) {
    return prisma.project.delete({
        where: {
            projectID_userId: {
                projectID,
                userId
            }
        }
    });
} 

export async function updateProject(projectID: string, userId: string, data: ProjectUpdateInput) {
    return prisma.project.update({
        where: {
            projectID_userId: {
                projectID,
                userId
            }
        },
        data
    });
}